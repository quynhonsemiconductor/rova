/*
 * Vietnamese edition, chapter 09-portfolio-capacity (US-119). Converted from the BA's static page
 * `public/guide/09-portfolio-capacity.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-09">
        <div>
          <ChapterEyebrow>PHẦN 09 · PORTFOLIO & CAPACITY</ChapterEyebrow>
          <h2>Từ mục tiêu lớn đến kế hoạch năng lực thực tế</h2>
          <Lead>
            <strong>Portfolio Items</strong> tổ chức mục tiêu theo chuỗi Epic → Feature → User
            Story/Defect. <strong>Capacity Planning</strong> phân bổ Feature của một Release cho các
            Team trong kế hoạch mà không thay đổi Project hoặc Team thực thi gốc của Feature.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Chọn đúng phạm vi khi xem Epic hoặc Feature.</li>
            <li>Tạo và cập nhật Portfolio Item đúng cấp.</li>
            <li>Đọc tiến độ theo Estimate và Count.</li>
            <li>Tạo Capacity Plan theo một Release.</li>
            <li>Phân bổ Feature, Publish và mở lại Plan khi cần.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-portfolio-items"
        number="09.1"
        title="Mở Portfolio Items đúng phạm vi"
        lead="Phạm vi Team quyết định loại Portfolio Item bạn có thể xem."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn đúng Project</strong>
              <p>Mở context selector trên thanh đầu trang và chọn Project cần quản lý.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Team hoặc All Teams</strong>
              <p>
                Dùng <b>All Teams</b> khi xem Epic cấp Project. Chọn một Team cụ thể khi tập trung
                vào Feature của Team đó.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Mở Portfolio → Portfolio Items</strong>
              <p>
                Chọn Type = Epic hoặc Feature. Dùng Search portfolio, Filters và Show Fields để thu
                gọn danh sách.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra tiêu đề phạm vi</strong>
              <p>Đối chiếu Project · Team trên đầu trang trước khi tạo, sửa hoặc archive.</p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Epic chỉ xuất hiện ở All Teams.</strong> Khi đang ở một Team cụ thể, Type = Epic
          có thể không hiển thị dữ liệu. Đây là hành vi theo phạm vi, không phải Epic bị mất.
        </p>
        <p>
          Workspace Admin và Admin của Project có thể quản lý Portfolio Items trong phạm vi được
          cấp. Editor hoặc tài khoản không có quyền Project không dùng màn hình này.
        </p>
      </Section>
      <Section
        id="phan-biet-epic-feature"
        number="09.2"
        title="Phân biệt Epic và Feature"
        lead="Chọn đúng cấp để tránh đưa mục tiêu lớn xuống Team hoặc tạo Feature quá rộng."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Đối tượng</th>
              <th>Dùng để mô tả</th>
              <th>Phạm vi và liên kết</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Epic</strong>
              </td>
              <td>Mục tiêu lớn ở cấp Project, dùng để nhóm các Feature cùng hướng kết quả.</td>
              <td>
                Thuộc một Project; không có Team và Release trực tiếp. Có thể chứa nhiều Feature.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Feature</strong>
              </td>
              <td>Năng lực sản phẩm có thể được Team triển khai và theo dõi tiến độ.</td>
              <td>
                Thuộc một Project; có thể chọn Team, Epic, Release và Owner. US/DE liên kết trực
                tiếp với Feature.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Capacity Planning chỉ phân bổ Feature.</strong> Epic dùng để định hướng và tổng
          hợp tiến độ; không đưa Epic vào Capacity Plan.
        </p>
        <p>
          Archive vẫn giữ lịch sử. Epic chỉ được archive khi không còn Feature con đang hoạt động;
          thao tác này không tự archive các Feature con.
        </p>
      </Section>
      <Section
        id="tao-cap-nhat-portfolio"
        number="09.3"
        title="Tạo và cập nhật Portfolio Item"
        lead="Chuẩn bị đúng Project, Owner và quan hệ cha trước khi lưu."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Khi tạo</th>
              <th>Trường chính</th>
              <th>Điểm cần kiểm tra</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Epic</strong>
              </td>
              <td>Name, Project, Owner, State, Preliminary Estimate.</td>
              <td>Không chọn Team hoặc Release.</td>
            </tr>
            <tr>
              <td>
                <strong>Feature</strong>
              </td>
              <td>Name, Owner, Team, Release, Epic, State, Preliminary Estimate, Description.</td>
              <td>Epic, Team và Release phải cùng Project.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Type cần tạo</strong>
              <p>Trên Portfolio Items, chọn Epic hoặc Feature rồi dùng nút New tương ứng.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Nhập Name và Owner</strong>
              <p>
                Tên nên mô tả kết quả cần đạt. Danh sách Owner phụ thuộc quyền và membership hợp lệ.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Hoàn thiện quan hệ</strong>
              <p>
                Với Feature, chọn Team, Release và Epic khi đã xác định. Chọn Epic = Unassigned nếu
                chưa có Epic cha.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn cách hoàn tất</strong>
              <p>
                Create lưu và quay lại danh sách. Create with details mở trang chi tiết để bổ sung
                Description, Notes, Attachments và What Success Looks Like.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Kiểm tra Children</strong>
              <p>
                Epic Children hiển thị Feature; Feature Children hiển thị User Story/Defect và Task
                bên dưới.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Feature không có Plan Estimate riêng.</strong> Preliminary Estimate và Refined
          Estimate là ước lượng cấp Feature; Plan Estimate nằm ở User Story/Defect và được dùng cho
          rollup.
        </p>
      </Section>
      <Section
        id="doc-tien-do-portfolio"
        number="09.4"
        title="Đọc tiến độ Portfolio"
        lead="Hai cột phần trăm trả lời hai câu hỏi khác nhau."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Chỉ số</th>
              <th>Cách hiểu</th>
              <th>Khi phù hợp</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>% Done by Est.</strong>
              </td>
              <td>Plan Estimate của US/DE ở Accepted hoặc Release chia cho tổng Plan Estimate.</td>
              <td>Khi các item có kích thước khác nhau và Plan Estimate được nhập đủ.</td>
            </tr>
            <tr>
              <td>
                <strong>% Done by Count</strong>
              </td>
              <td>Số US/DE ở Accepted hoặc Release chia cho tổng số US/DE.</td>
              <td>Khi cần đọc nhanh số lượng item hoàn tất.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Với Feature, dữ liệu lấy từ US/DE liên kết trực tiếp. Với Epic, dữ liệu tổng hợp từ US/DE
          thuộc các Feature con đang hoạt động. Task không được tính trực tiếp.
        </p>
        <p>
          <strong>Completed chưa phải Accepted trong Portfolio.</strong> US/DE chỉ đi vào tử số khi
          ở Accepted hoặc Release.
        </p>
        <p>
          Khi mẫu số bằng 0, giao diện hiển thị 0%. Hãy mở Children để kiểm tra item thiếu Plan
          Estimate hoặc chưa có dữ liệu trước khi kết luận.
        </p>
      </Section>
      <Section
        id="tao-capacity-plan"
        number="09.5"
        title="Tạo Capacity Plan"
        lead="Mỗi Plan thuộc một Project, tham chiếu một Release và dùng một đơn vị cố định."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Portfolio → Capacity Planning</strong>
              <p>
                Kiểm tra Project trên thanh đầu trang. Dùng Search plans, Filters hoặc Show Fields
                khi danh sách có nhiều Plan.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Form hiển thị Project, Plan Type = Single Release và Portfolio Item Type = Feature.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập Name và chọn Release</strong>
              <p>
                Release là bắt buộc và phải thuộc Project hiện tại. Mỗi cặp Project + Release chỉ có
                một Capacity Plan.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn Unit</strong>
              <p>
                Chọn <b>points</b> để dùng Plan Estimate hoặc <b>items</b> để dùng số lượng. Unit
                không thể đổi sau khi tạo.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Chọn Create</strong>
              <p>Plan mới ở trạng thái Draft và chưa tự thêm Team hoặc Feature.</p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="phan-bo-capacity"
        number="09.6"
        title="Phân bổ Feature và Capacity cho Team"
        lead="Phân bổ chỉ tồn tại trong Plan và không đổi Project hoặc Team thực thi gốc của Feature."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Thêm Team vào Plan</strong>
              <p>
                Dùng Add Team và chọn Team thuộc Project. Capacity được nhập thủ công cho Plan này
                và mặc định là 0.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Thêm Feature</strong>
              <p>
                Thêm từ tab Features để đưa vào Not assigned, hoặc thêm từ Team đang mở để gán sẵn
                Team đó.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Gán hoặc chia allocation</strong>
              <p>
                Dùng Planned Team Assignment cho một Team. Dùng Allocate khi chia một Feature cho
                nhiều Team.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Đọc Demand và Capacity</strong>
              <p>
                Demand là tổng allocation của Team. So sánh Complete, Rollup, Estimated và Capacity
                để nhận biết quá tải hoặc thiếu ước lượng.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Điều chỉnh khi cần</strong>
              <p>
                Unassign giữ Feature trong Plan và đưa về Not assigned. Remove from Plan gỡ toàn bộ
                allocation nhưng không archive Feature.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Cảnh báo chỉ mang tính tư vấn.</strong> Rollup lớn hơn Estimated, Demand lớn hơn
          Capacity hoặc thiếu estimate cần được xem xét; hệ thống không tự cân bằng.
        </p>
        <p>
          Capacity Forecast là công cụ hỗ trợ ở Draft. Giá trị chỉ được áp dụng khi người dùng xác
          nhận và không liên tục tự tính lại.
        </p>
      </Section>
      <Section
        id="publish-capacity-plan"
        number="09.7"
        title="Publish và mở lại Capacity Plan"
        lead="Kiểm tra phạm vi, tổng Capacity và cảnh báo trước khi khóa Plan."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Thao tác</th>
              <th>Kết quả</th>
              <th>Điểm cần nhớ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Publish Without Updating Fields</strong>
              </td>
              <td>Chuyển Plan sang Published và thay đổi khả năng hiển thị.</td>
              <td>Không sao chép Release hoặc ngày kế hoạch sang Feature.</td>
            </tr>
            <tr>
              <td>
                <strong>Publish</strong>
              </td>
              <td>
                Chuyển sang Published và cập nhật các trường Feature được phép khi điều kiện ngày
                hợp lệ.
              </td>
              <td>Không đổi Project/Team của Feature và không cập nhật US/DE.</td>
            </tr>
            <tr>
              <td>
                <strong>Revert to Draft</strong>
              </td>
              <td>Mở khóa Plan để tiếp tục chỉnh sửa.</td>
              <td>Không tự hoàn tác các giá trị đã sao chép ở lần Publish trước.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Published là chỉ đọc.</strong> Muốn thêm Team, đổi Capacity, thêm Feature hoặc sửa
          allocation, Admin phải Revert to Draft trước.
        </p>
        <p>
          Nếu ngày của Plan không khớp Release, hệ thống có thể vẫn Publish khả năng hiển thị nhưng
          không được âm thầm ghi đè Release trên Feature. Hãy đọc thông báo kết quả trước khi rời
          trang.
        </p>
      </Section>
      <Section
        id="xu-ly-portfolio-capacity"
        number="09.8"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra phạm vi, quyền và trạng thái trước khi tạo lại dữ liệu."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy Epic</strong>
              <p>Chuyển sang All Teams, chọn Type = Epic và bỏ Search/Filters.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không thấy Feature hoặc Owner</strong>
              <p>
                Kiểm tra Project, Team, quyền và membership. Các lựa chọn trong form phải cùng
                Project.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Không archive được Epic</strong>
              <p>Epic còn Feature con hoạt động. Gỡ quan hệ hoặc xử lý Feature con trước.</p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Tiến độ là 0%</strong>
              <p>
                Mở Children, kiểm tra trạng thái US/DE và Plan Estimate. Completed chưa được tính là
                Accepted.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Không tạo được Capacity Plan</strong>
              <p>
                Kiểm tra Release bắt buộc, quyền Admin và Plan có thể đã tồn tại cho cùng Project +
                Release.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Không sửa được allocation</strong>
              <p>
                Plan đang Published hoặc tài khoản chỉ có quyền xem. Revert to Draft bằng tài khoản
                có quyền.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Feature biến mất sau khi gỡ Team</strong>
              <p>Kiểm tra tab Features và Not assigned. Gỡ Team phải giữ Feature trong Plan.</p>
            </div>
          </article>
          <article>
            <span>09</span>
            <div>
              <strong>Tổng số bị lặp khi chia nhiều Team</strong>
              <p>
                Plan total chỉ tính mỗi allocation một lần; không cộng thêm dòng tổng của Feature.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
        <ul>
          <li>Bạn biết vì sao Epic chỉ xuất hiện ở All Teams chưa?</li>
          <li>Bạn phân biệt % Done by Est. với % Done by Count chưa?</li>
          <li>Bạn biết Unit của Capacity Plan không đổi được sau khi tạo chưa?</li>
          <li>Bạn phân biệt Unassign, Remove from Plan và Revert to Draft chưa?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
