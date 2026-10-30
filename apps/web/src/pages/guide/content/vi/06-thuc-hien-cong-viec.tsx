/*
 * Vietnamese edition, chapter 06-thuc-hien-cong-viec (US-119). Converted from the BA's static page
 * `public/guide/06-thuc-hien-cong-viec.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DefinitionGrid,
  InstructionList,
  IterationStateCard,
  IterationStateFlow,
  Lead,
  ResultBox,
  ScenarioCard,
  ScenarioFlow,
  ScenarioHead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-06">
        <div>
          <ChapterEyebrow>PHẦN 06 · THỰC HIỆN CÔNG VIỆC</ChapterEyebrow>
          <h2>Theo dõi việc thực hiện bằng Task</h2>
          <Lead>
            Mỗi <strong>Task</strong> là một việc cụ thể nằm dưới User Story hoặc Defect. Trong quá
            trình làm, bạn cập nhật người phụ trách, trạng thái và số giờ trực tiếp trên Task.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Mở danh sách Task của một US hoặc DE.</li>
            <li>Tạo Task con và giao đúng Owner.</li>
            <li>Cập nhật Task State theo tiến độ thực tế.</li>
            <li>Phân biệt Estimate, To Do và Actual.</li>
            <li>Bổ sung mô tả, tài liệu và xem lịch sử thay đổi.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-task-list"
        number="06.1"
        title="Mở danh sách Task của US hoặc Defect"
        lead="Task không nằm thành một dòng độc lập trong Backlog. Hãy mở Work Item cha rồi chuyển sang tab Tasks."
      >
        <GuideShot
          name="05-tasks-tab-production"
          alt="Tab Tasks hiển thị Add Task, Filters, Show Fields, các cột trạng thái, Owner và giờ."
          caption="Tab Tasks của User Story và danh sách Task con."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở US hoặc DE cần thực hiện</strong>
              <p>
                Tìm Work Item từ Backlog, Iteration Status, Team Status hoặc ô Search trên thanh đầu
                trang, rồi chọn ID của item.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn tab Tasks</strong>
              <p>
                Con số trước tên tab cho biết số Task con đang có. Danh sách chỉ hiển thị Task thuộc
                Work Item đang mở.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc danh sách công việc</strong>
              <p>
                Các cột chính gồm Rank, ID, Name, State, Owner, Project, Teams, To Do, Actuals và
                Estimate. Dòng Totals cộng riêng từng trường giờ.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Mở Task cần xử lý</strong>
              <p>
                Chọn ID như <b>TA-22</b> để mở Task Detail. Tại đây bạn có thể cập nhật nội dung,
                trạng thái, Owner và giờ.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Task đi theo Work Item cha</strong>
          <p>
            Task kế thừa Project, Team và Iteration từ US/DE cha. Task không có Iteration riêng và
            không xuất hiện như một item độc lập trong Backlog.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-task-con"
        number="06.2"
        title="Tạo Task con"
        lead="Tách US/DE thành những việc đủ cụ thể để một người có thể nhận và cập nhật tiến độ."
      >
        <GuideShot
          name="05-add-task-production"
          alt="Form Create Task với Name, Project, Estimate, To Do, Actuals, Owner và các nút lưu."
          caption="Form Add Task và các trường cần điền."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở tab Tasks và chọn Add Task</strong>
              <p>
                Task mới sẽ được tạo dưới đúng US hoặc DE đang mở. Kiểm tra Work Item cha trước khi
                nhập.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Nhập Name</strong>
              <p>
                Viết một hành động cụ thể, ví dụ <b>Xây dựng bộ lọc Priority</b>. Name là trường bắt
                buộc.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập giờ ban đầu</strong>
              <p>
                Điền Estimate nếu đã có ước lượng. Có thể nhập riêng To Do và Actuals; không nhập số
                âm.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn Owner</strong>
              <p>
                Chọn một thành viên hợp lệ của Team cha hoặc <b>— No Entry —</b> nếu chưa giao việc.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Lưu Task</strong>
              <p>
                Chọn <b>Create Task</b> để tạo nhanh. Chọn <b>Create with details</b> khi muốn
                chuyển ngay sang trang chi tiết để bổ sung nội dung.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>KẾT QUẢ</span> <strong>Task xuất hiện trong tab Tasks của US/DE cha</strong>
          <p>
            Kiểm tra ID, Name, State, Owner và ba giá trị giờ trong danh sách. Task mới dùng trạng
            thái <b>Defined</b>.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="giao-task"
        number="06.3"
        title="Giao Task cho đúng người"
        lead="Owner cho biết người chịu trách nhiệm chính. Danh sách lựa chọn phụ thuộc Team của Work Item cha."
      >
        <DefinitionGrid>
          <article>
            <span>01</span>
            <div>
              <strong>Owner</strong>
              <p>
                Người đang chịu trách nhiệm cho Task. Bạn có thể chọn khi tạo hoặc cập nhật lại
                trong Task Detail và danh sách Tasks.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Dev Owner</strong>
              <p>
                Trường bổ sung trên Task Detail để ghi nhận người phụ trách phát triển khi quy trình
                của Team sử dụng vai trò này.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>— No Entry —</strong>
              <p>
                Dùng khi chưa xác định người nhận việc. Task vẫn được tạo nhưng cần được giao lại
                trước khi theo dõi cá nhân.
              </p>
            </div>
          </article>
        </DefinitionGrid>
        <p>
          Danh sách Owner chỉ gồm các thành viên đang hợp lệ của Team cha. Nếu không thấy một người,
          hãy kiểm tra Team của US/DE và membership của người đó; không đổi Team chỉ để làm tên xuất
          hiện.
        </p>
      </Section>
      <Section
        id="cap-nhat-task-state"
        number="06.4"
        title="Cập nhật trạng thái Task"
        lead="Task dùng một bộ trạng thái riêng, ngắn hơn trạng thái của User Story và Defect."
      >
        <IterationStateFlow>
          <IterationStateCard>
            <span>1</span>
            <div>
              <h3>Defined</h3>
              <p>Task đã được ghi nhận nhưng chưa bắt đầu thực hiện.</p>
            </div>
          </IterationStateCard>
          <IterationStateCard>
            <span>2</span>
            <div>
              <h3>In-Progress</h3>
              <p>
                Task đang được thực hiện. Chuyển sang trạng thái này khi công việc đã thực sự bắt
                đầu.
              </p>
            </div>
          </IterationStateCard>
          <IterationStateCard>
            <span>3</span>
            <div>
              <h3>Completed</h3>
              <p>
                Task đã hoàn tất. Kiểm tra Actual và To Do trước khi đóng để số giờ phản ánh đúng
                thực tế.
              </p>
            </div>
          </IterationStateCard>
        </IterationStateFlow>
        <p>
          Bạn có thể đổi Task State trong tab Tasks, Task Detail hoặc Team Status nếu có quyền truy
          cập màn đó. Khi tất cả Task con của cùng một US/DE đều Completed, hệ thống tự chuyển Work
          Item cha sang Completed. Nếu mở lại bất kỳ Task nào, Work Item cha tự về In-Progress.
        </p>
        <Callout tone="warning">
          <strong>Đổi trạng thái không tự cập nhật giờ</strong>
          <p>
            Completed hoặc mở lại Task không thay đổi Estimate, To Do hay Actual. Người thực hiện
            phải cập nhật các giá trị giờ riêng.
          </p>
        </Callout>
      </Section>
      <Section
        id="cap-nhat-gio-task"
        number="06.5"
        title="Cập nhật Estimate, To Do và Actual"
        lead="Ba trường cùng dùng đơn vị giờ nhưng trả lời ba câu hỏi khác nhau."
      >
        <GuideShot
          name="05-task-detail-production"
          alt="Task Detail với Task State, Owner, Dev Owner, Work Product, Estimate, To Do và Actual."
          caption="Task Detail; panel bên phải chứa trạng thái, người phụ trách và ba trường giờ độc lập."
        />
        <DefinitionGrid>
          <article>
            <span>01</span>
            <div>
              <strong>Estimate</strong>
              <p>Tổng số giờ ước lượng để hoàn thành Task tại thời điểm lập kế hoạch.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>To Do</strong>
              <p>Số giờ còn lại theo đánh giá hiện tại của người thực hiện.</p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Actual</strong>
              <p>Số giờ đã thực hiện và được nhập trực tiếp trên Task.</p>
            </div>
          </article>
        </DefinitionGrid>
        <p>
          Khi tạo Task, nếu bạn nhập Estimate và để trống To Do, hệ thống sao chép Estimate sang To
          Do đúng một lần. Sau khi Task đã được tạo, ba trường hoạt động độc lập: sửa một trường
          không tự tính lại hai trường còn lại.
        </p>
        <ScenarioCard>
          <ScenarioHead>
            <span>VÍ DỤ</span>
            <div>
              <h3>Cập nhật sau một buổi làm việc</h3>
              <p>Task được tạo với Estimate 6 giờ và To Do ban đầu là 6 giờ.</p>
            </div>
          </ScenarioHead>
          <ScenarioFlow>
            <li>
              <span>1</span>
              <div>
                <strong>Đã làm 2 giờ</strong>
                <p>Người thực hiện nhập Actual = 2.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Còn khoảng 4 giờ</strong>
                <p>Người thực hiện nhập To Do = 4.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Estimate vẫn là 6</strong>
                <p>Hệ thống không dùng công thức bắt buộc Actual + To Do = Estimate.</p>
              </div>
            </li>
          </ScenarioFlow>
        </ScenarioCard>
        <p>
          Task Detail dùng trường <b>Actual</b> để nhập giờ trực tiếp; hướng dẫn này không sử dụng
          màn Timesheet hoặc Time Entry riêng.
        </p>
      </Section>
      <Section
        id="bo-sung-task"
        number="06.6"
        title="Bổ sung thông tin và xem lịch sử"
        lead="Dùng Task Detail khi cần ghi rõ cách thực hiện, đính kèm tài liệu hoặc kiểm tra thay đổi."
      >
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Description</strong>
              <p>Mô tả phạm vi, kết quả cần có hoặc lưu ý kỹ thuật của Task.</p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Attachments</strong>
              <p>
                Đính kèm tệp liên quan trực tiếp đến công việc; tránh đưa mật khẩu hoặc dữ liệu nhạy
                cảm.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Linked Items</strong>
              <p>
                Liên kết item liên quan khi cần tra cứu chéo. Work Product cha vẫn được hiển thị
                riêng ở panel chi tiết.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Notes và Comments</strong>
              <p>Notes lưu ghi chú của Task; Comments dùng cho trao đổi theo dòng thời gian.</p>
            </div>
          </article>
          <article>
            <span>5</span>
            <div>
              <strong>Revision History</strong>
              <p>
                Xem các lần cập nhật của Task, gồm thay đổi trạng thái, người phụ trách hoặc trường
                giờ đã được ghi nhận.
              </p>
            </div>
          </article>
        </ActionGrid>
      </Section>
      <Section
        id="xu-ly-task"
        number="06.7"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra Work Item cha, Team và quyền trước khi tạo lại hoặc sửa dữ liệu."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy tab Tasks</strong>
              <p>
                Kiểm tra item đang mở là User Story hoặc Defect. Task Detail không có tab Tasks con.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Không thấy Task trong Backlog</strong>
              <p>
                Đây là hành vi bình thường. Mở US/DE cha hoặc dùng Team Status để tìm Task theo
                Iteration và Owner.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Không thấy người cần chọn trong Owner</strong>
              <p>
                Kiểm tra người đó có phải thành viên hợp lệ của Team cha hay không. Nếu chưa giao
                được, chọn No Entry và báo người quản lý Team.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>To Do không giảm khi nhập Actual</strong>
              <p>
                Hai trường độc lập. Hãy cập nhật To Do theo đánh giá còn lại thay vì chờ hệ thống tự
                trừ.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Giờ không đổi khi Completed</strong>
              <p>
                Đúng theo quy tắc hiện tại. Trạng thái không tự đặt To Do về 0 hoặc thay đổi Actual.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>US/DE cha tự đổi trạng thái</strong>
              <p>
                Khi toàn bộ Task con Completed, item cha tự Completed; mở lại một Task sẽ đưa item
                cha về In-Progress.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
          <ul>
            <li>Task đang nằm dưới đúng US hoặc DE chưa?</li>
            <li>Owner có thuộc Team của Work Item cha không?</li>
            <li>Task State có phản ánh tiến độ thực tế không?</li>
            <li>Estimate, To Do và Actual đã được cập nhật riêng chưa?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
